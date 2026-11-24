import { describe, expect, it } from "vitest";
import { profileDegree } from "../profile-degree";

const read = (...lines: (string | [string, boolean])[]) =>
  profileDegree({ universities: lines.map((l) => (Array.isArray(l) ? { name: "U", evidence: l[0], completedDegree: l[1] } : { name: "U", evidence: l, completedDegree: true })) });

describe("profileDegree (the résumé's degree for the one-tap confirm)", () => {
  it("reads the level and the field from common résumé lines", () => {
    expect(read("B.A. in English – Dagon University, Myanmar (2019 – 2020)")).toEqual({ degree: "Bachelor's", field: "English" });
    expect(read("Bachelor of Science in Biology, Kasetsart University")).toEqual({ degree: "Bachelor's", field: "Biology" });
    expect(read("Bachelor of Arts in English, 2020-2023 GPA 3.75")).toEqual({ degree: "Bachelor's", field: "English" });
    expect(read("Bachelor of Science (Software Engineering) Apadana Institute")).toEqual({ degree: "Bachelor's", field: "Software Engineering" });
    expect(read("B.Sc. in Business Information Technology (2nd Class Hons.) – University of Greenwich")).toEqual({ degree: "Bachelor's", field: "Business Information Technology" });
    expect(read("BSc (Hons) Biomedical Science. Manchester Metropolitan University")).toEqual({ degree: "Bachelor's", field: "Biomedical Science" });
    expect(read("Thai Nichi international College B.Eng [Digital Engineering]")).toEqual({ degree: "Bachelor's", field: "Digital Engineering" });
    expect(read("Bachelor of Secondary Education, University of Saint Louis")).toEqual({ degree: "Bachelor's", field: "Secondary Education" });
    expect(read("MA IN EDUCATION MAJOR IN ENGLISH LANGUAGE TEACHING CEBU NORMAL UNIVERSITY")).toEqual({ degree: "Master's", field: "Education" });
    expect(read("Master of Arts (Economics) University of Colorado")).toEqual({ degree: "Master's", field: "Economics" });
    expect(read("PhD in Anatomy and Structural Biology\nMahidol University")).toEqual({ degree: "PhD", field: "Anatomy and Structural Biology" });
  });
  it("uses the highest completed degree, and gives nothing when that degree names no field", () => {
    expect(read("B.A. in English", "M.A. in Linguistics, Payame Noor University")).toEqual({ degree: "Master's", field: "Linguistics" });
    expect(read("B.A. in English", "Master of Arts, Yangon University")).toBeNull();
    expect(read("BACHELOR OF ARTS Assumption University Finished 2021")).toBeNull();
    expect(read("Bachelor of Science University of Mines and Technology")).toBeNull();
  });
  it("does not read a professional doctorate as a PhD", () => {
    expect(read("Doctor of Medicine (MD), Mahidol University")).toBeNull();
    expect(read("Doctor of Veterinary Medicine (DVM) Bahauddin Zakariya University")).toBeNull();
  });
  it("ignores a degree that is not complete, and reads nothing from no assessment", () => {
    expect(read(["MSc in Physics, in progress", false], "B.Sc. Mathematics, Mandalay")).toEqual({ degree: "Bachelor's", field: "Mathematics" });
    expect(profileDegree(null)).toBeNull();
    expect(profileDegree({ universities: [] })).toBeNull();
  });
  it("never returns an abbreviation, a cut phrase or an institution as the field", () => {
    expect(read("Master of Science M.Sc")?.field).not.toBe("M.Sc");
    expect(read("Bachelor of Science in")).toBeNull();
    expect(read("Bachelor of Arts East Yangon University")).toBeNull();
    // A field run into the university name is not split by guesswork: the questions are asked instead.
    expect(read("Bachelor of Secondary Education University of Saint Louis")).toBeNull();
    expect(read("MA in English,2010 North Eastern Hill University")).toEqual({ degree: "Master's", field: "English" });
  });
});
